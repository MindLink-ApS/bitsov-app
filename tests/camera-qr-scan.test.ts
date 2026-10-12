// Desktop QR scan: fixture frames only (a QR drawn from our own encoder, and
// blank frames). No camera, no network, no stored frames.
import { afterEach, describe, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import { qrMatrix } from '../src/qr';
import { cameraQrScannerAvailable, decodeFrame, scanQrWithCamera, SCAN_TIMEOUT_MS, type QrDecode, type ScanDeps } from '../src/cameraQrScanner';

const decode = jsQR as unknown as QrDecode;
const LINK = 'bitsov://pair/eyJ2IjoxLCJlbmRwb2ludCI6IjIwMy4wLjExMy43Ojg0NDMifQ_sample-ticket';

/** A QR code as camera pixels: black modules on white, `scale` px each, with a quiet zone. */
function frameOf(text: string, scale = 6, quiet = 4): ImageData {
  const m = qrMatrix(text);
  const size = (m.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  m.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }));
  return { data, width: size, height: size, colorSpace: 'srgb' } as ImageData;
}
const blank = (size = 120): ImageData => ({ data: new Uint8ClampedArray(size * size * 4).fill(255), width: size, height: size, colorSpace: 'srgb' } as ImageData);

function fakeCamera() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  return { stream, tracks, stopped: () => tracks.every((t) => t.stop.mock.calls.length === 1) };
}
function deps(over: Partial<ScanDeps> & { frames?: (ImageData | null)[] }, cam = fakeCamera()) {
  const frames = over.frames ?? [];
  let n = 0;
  const hide = vi.fn();
  let cancel: () => void = () => {};
  let fail: () => void = () => {};
  const d: ScanDeps = {
    getUserMedia: vi.fn(async () => cam.stream),
    loadDecoder: vi.fn(async () => decode),
    grab: () => frames[Math.min(n++, frames.length - 1)] ?? null,
    show: vi.fn((_s, c, f) => { cancel = c; fail = f; return hide; }),
    ...over,
  };
  return { d, cam, hide, cancel: () => cancel(), fail: () => fail() };
}

afterEach(() => { vi.useRealTimers(); });

describe('decoding a frame', () => {
  it('reads a pairing link from a QR fixture', () => {
    expect(decodeFrame(decode, frameOf(LINK))).toBe(LINK);
  });
  it('reads it inverted too (light on dark screens)', () => {
    const f = frameOf(LINK);
    for (let i = 0; i < f.data.length; i += 4) { f.data[i] = 255 - f.data[i]; f.data[i + 1] = 255 - f.data[i + 1]; f.data[i + 2] = 255 - f.data[i + 2]; }
    expect(decodeFrame(decode, f)).toBe(LINK);
  });
  it('a frame with no QR is null', () => {
    expect(decodeFrame(decode, blank())).toBeNull();
  });
});

describe('scanning with the camera', () => {
  it('returns the link from the first readable frame and turns the camera off', async () => {
    const { d, cam, hide } = deps({ frames: [null, blank(), frameOf(LINK)] });
    await expect(scanQrWithCamera(d)).resolves.toBe(LINK);
    expect(cam.stopped()).toBe(true);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(d.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' }, audio: false });
  });

  it('Cancel stops every track and rejects without any scanner text', async () => {
    const { d, cam, hide, cancel } = deps({ frames: [blank()] });
    const scan = scanQrWithCamera(d);
    await vi.waitFor(() => expect(d.show).toHaveBeenCalled());
    cancel();
    await expect(scan).rejects.toThrow('Scanning did not complete.');
    expect(cam.stopped()).toBe(true);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('times out: the camera is off and it rejects', async () => {
    vi.useFakeTimers();
    const { d, cam } = deps({ frames: [blank()], timeoutMs: 5_000 });
    const scan = scanQrWithCamera(d);
    const settled = expect(scan).rejects.toThrow('Scanning did not complete.');
    await vi.advanceTimersByTimeAsync(5_001);
    await settled;
    expect(cam.stopped()).toBe(true);
  });

  it('a camera that opens after a timeout is stopped at once and never shown', async () => {
    vi.useFakeTimers();
    let open!: (s: MediaStream) => void;
    const cam = fakeCamera();
    const { d } = deps({ getUserMedia: vi.fn(() => new Promise<MediaStream>((r) => { open = r; })), timeoutMs: 1_000 }, cam);
    const scan = scanQrWithCamera(d);
    const settled = expect(scan).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_001);
    await settled;
    open(cam.stream);
    await vi.advanceTimersByTimeAsync(1);
    expect(cam.stopped()).toBe(true);
    expect(d.show).not.toHaveBeenCalled();
  });

  it('a denied camera rejects; nothing was shown', async () => {
    const { d } = deps({ getUserMedia: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); }) });
    await expect(scanQrWithCamera(d)).rejects.toThrow('Scanning did not complete.');
    expect(d.show).not.toHaveBeenCalled();
  });

  it('a frame error stops the camera and rejects', async () => {
    const { d, cam } = deps({ grab: () => { throw new Error('canvas tainted'); } });
    await expect(scanQrWithCamera(d)).rejects.toThrow('Scanning did not complete.');
    expect(cam.stopped()).toBe(true);
  });

  it('the decoder is loaded only when a scan starts', async () => {
    const { d } = deps({ frames: [frameOf(LINK)] });
    expect(d.loadDecoder).not.toHaveBeenCalled();
    await scanQrWithCamera(d);
    expect(d.loadDecoder).toHaveBeenCalledTimes(1);
  });

  it('decoder fails before the camera opens: the camera that opens later is stopped at once', async () => {
    let open!: (s: MediaStream) => void;
    const cam = fakeCamera();
    const { d } = deps({
      getUserMedia: vi.fn(() => new Promise<MediaStream>((r) => { open = r; })),
      loadDecoder: vi.fn(async () => { throw new Error('chunk failed'); }),
    }, cam);
    await expect(scanQrWithCamera(d)).rejects.toThrow('Scanning did not complete.');
    // The permission prompt is answered only now.
    open(cam.stream);
    await vi.waitFor(() => expect(cam.stopped()).toBe(true));
    expect(d.show).not.toHaveBeenCalled();
  });

  it('decoder fails after the camera opened: every track stops', async () => {
    let failDecoder!: (e: Error) => void;
    const cam = fakeCamera();
    const { d } = deps({ loadDecoder: vi.fn(() => new Promise<QrDecode>((_, no) => { failDecoder = no; })) }, cam);
    const scan = scanQrWithCamera(d);
    await vi.waitFor(() => expect(d.getUserMedia).toHaveBeenCalled());
    await Promise.resolve();
    failDecoder(new Error('chunk failed'));
    await expect(scan).rejects.toThrow('Scanning did not complete.');
    expect(cam.stopped()).toBe(true);
  });

  it('a decoder that hangs: its own deadline ends the scan and the camera is off', async () => {
    vi.useFakeTimers();
    const cam = fakeCamera();
    const { d } = deps({ loadDecoder: vi.fn(() => new Promise<QrDecode>(() => {})), decoderTimeoutMs: 2_000, timeoutMs: 60_000 }, cam);
    const scan = scanQrWithCamera(d);
    const settled = expect(scan).rejects.toThrow('Scanning did not complete.');
    await vi.advanceTimersByTimeAsync(2_001);
    await settled;
    expect(cam.stopped()).toBe(true);
  });

  it('a hanging decoder and a slow camera: the overall timeout still turns the late camera off', async () => {
    vi.useFakeTimers();
    let open!: (s: MediaStream) => void;
    const cam = fakeCamera();
    const { d } = deps({
      getUserMedia: vi.fn(() => new Promise<MediaStream>((r) => { open = r; })),
      loadDecoder: vi.fn(() => new Promise<QrDecode>(() => {})),
      decoderTimeoutMs: 60_000, timeoutMs: 5_000,
    }, cam);
    const settled = expect(scanQrWithCamera(d)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5_001);
    await settled;
    open(cam.stream);
    await vi.advanceTimersByTimeAsync(1);
    expect(cam.stopped()).toBe(true);
  });

  it('a viewfinder that cannot play ends the scan: camera off, error shown', async () => {
    const { d, cam, hide, fail } = deps({ frames: [blank()] });
    const scan = scanQrWithCamera(d);
    await vi.waitFor(() => expect(d.show).toHaveBeenCalled());
    fail();
    await expect(scan).rejects.toThrow('Scanning did not complete.');
    expect(cam.stopped()).toBe(true);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('a viewfinder that throws while being built ends the scan at once: camera off', async () => {
    const { d, cam } = deps({ frames: [blank()], show: vi.fn(() => { throw new Error('no video element'); }) });
    const scan = scanQrWithCamera(d);
    await expect(scan).rejects.toThrow('Scanning did not complete.');
    expect(cam.stopped()).toBe(true);
  });

  it('the default timeout is a minute', () => {
    expect(SCAN_TIMEOUT_MS).toBe(60_000);
  });
});

describe('where it is offered', () => {
  const media = { getUserMedia: () => Promise.reject(new Error('unused')) };
  it('a Mac webview with a camera API', () => {
    expect(cameraQrScannerAvailable('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15', media)).toBe(true);
  });
  it('not Android (native scanner), not iOS, not without a camera API', () => {
    expect(cameraQrScannerAvailable('Mozilla/5.0 (Linux; Android 14)', media)).toBe(false);
    expect(cameraQrScannerAvailable('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', media)).toBe(false);
    expect(cameraQrScannerAvailable('Mozilla/5.0 (Macintosh)', undefined)).toBe(false);
  });
});

describe('no network, nothing kept', () => {
  it('the scanner source makes no requests and keeps no frames', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(`${process.cwd()}/src/cameraQrScanner.ts`, 'utf8');
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|localStorage|indexedDB|toDataURL|toBlob/);
    // jsQR is a lazy chunk, never a static import.
    expect(src).not.toMatch(/^import .*jsqr/m);
    expect(src).toMatch(/await import\('jsqr'\)/);
  });
});
