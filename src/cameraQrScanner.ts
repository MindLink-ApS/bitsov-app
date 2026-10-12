/**
 * Scan a pairing QR with this computer's camera (macOS desktop). The camera
 * opens only after the owner presses Scan, frames are decoded in memory by
 * jsQR (loaded on that press, never at startup), nothing is stored or sent
 * anywhere, and every camera track stops on success, Cancel, error or timeout.
 * Android keeps its native scanner (pairingScanner.ts).
 */

/** jsQR's decode, as this module uses it. */
export type QrDecode = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }) => { data: string } | null;

export const SCAN_TIMEOUT_MS = 60_000;
const FRAME_MS = 150;

/** A desktop webview with a camera API (not Android, which has its own scanner). */
export function cameraQrScannerAvailable(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  media: unknown = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
): boolean {
  if (/\bAndroid\b|\biPhone\b|\biPad\b/i.test(userAgent)) return false;
  return typeof (media as MediaDevices | undefined)?.getUserMedia === 'function';
}

/** One decoded frame's text, trimmed; null when there is no readable QR in it. */
export function decodeFrame(decode: QrDecode, frame: { data: Uint8ClampedArray; width: number; height: number }): string | null {
  const found = decode(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
  const text = found?.data.trim();
  return text ? text : null;
}

export type ScanDeps = {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  /** Loads jsQR on demand (a separate chunk). */
  loadDecoder: () => Promise<QrDecode>;
  /** The current camera frame, or null before the first one. Reused, never kept. */
  grab: (stream: MediaStream) => ImageData | null;
  /** Shows the viewfinder; returns its teardown. Its Cancel calls `cancel`. */
  show: (stream: MediaStream, cancel: () => void) => () => void;
  timeoutMs?: number;
};

const SCAN_FAILED = 'Scanning did not complete.';

/**
 * Open the camera, read frames until one holds a QR code, and return its
 * text. Rejects on Cancel, timeout, a denied camera or any error; the camera
 * is off again before the promise settles.
 */
export function scanQrWithCamera(deps: ScanDeps): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stream: MediaStream | null = null;
    let hide: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    let done = false;
    const finish = (text: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(tick);
      for (const track of stream?.getTracks() ?? []) {
        try { track.stop(); } catch { /* Stop the others regardless. */ }
      }
      stream = null;
      try { hide?.(); } catch { /* The viewfinder is gone either way. */ }
      hide = null;
      if (text) resolve(text);
      else reject(new Error(SCAN_FAILED));
    };
    timer = setTimeout(() => finish(null), deps.timeoutMs ?? SCAN_TIMEOUT_MS);
    void (async () => {
      try {
        const [decode, media] = await Promise.all([
          deps.loadDecoder(),
          deps.getUserMedia({ video: { facingMode: 'environment' }, audio: false }),
        ]);
        // Cancelled or timed out while the camera was opening: it stops at once.
        if (done) { media.getTracks().forEach((t) => t.stop()); return; }
        stream = media;
        hide = deps.show(media, () => finish(null));
        tick = setInterval(() => {
          if (done || !stream) return;
          try {
            const frame = deps.grab(stream);
            const text = frame ? decodeFrame(decode, frame) : null;
            if (text) finish(text);
          } catch { finish(null); }
        }, FRAME_MS);
      } catch { finish(null); }
    })();
  });
}

/** The real dependencies: the webview's camera, a <video> viewfinder and an off-screen canvas. */
export function scanPairingLinkWithCamera(): Promise<string> {
  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  return scanQrWithCamera({
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    loadDecoder: async () => (await import('jsqr')).default as unknown as QrDecode,
    grab: () => {
      if (!video || video.readyState < 2 || !video.videoWidth) return null;
      canvas ??= document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    },
    show: (stream, cancel) => {
      const overlay = document.createElement('div');
      overlay.className = 'qr-scan-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Scan pairing QR');
      overlay.dataset.qrScan = '';
      const box = document.createElement('div');
      box.className = 'qr-scan-box';
      const title = document.createElement('p');
      title.className = 'qr-scan-title';
      title.textContent = 'Hold the pairing QR code up to the camera.';
      video = document.createElement('video');
      video.className = 'qr-scan-video';
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = stream;
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'Read on this computer only. Nothing is saved or sent.';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'quiet';
      close.dataset.qrScanCancel = '';
      close.textContent = 'Cancel';
      close.onclick = cancel;
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
      document.addEventListener('keydown', onKey);
      box.append(title, video, hint, close);
      overlay.append(box);
      document.body.append(overlay);
      void video.play?.()?.catch?.(() => undefined);
      close.focus();
      return () => {
        document.removeEventListener('keydown', onKey);
        if (video) { video.pause?.(); video.srcObject = null; }
        video = null;
        // The last frame is not kept: the canvas is emptied and dropped.
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        canvas = null;
        overlay.remove();
      };
    },
  });
}
