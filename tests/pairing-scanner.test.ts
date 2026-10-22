import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scanner = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  scan: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-barcode-scanner', () => ({
  Format: { QRCode: 'QR_CODE' },
  ...scanner,
}));

import { mobileQrScannerAvailable, scanPairingLink } from '../src/pairingScanner';

describe('Mobile pairing QR scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('__TAURI_INTERNALS__', {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is exposed only in a mobile Tauri webview', () => {
    expect(mobileQrScannerAvailable('Mozilla/5.0 (Linux; Android 15)')).toBe(true);
    expect(mobileQrScannerAvailable('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe(false);
    vi.unstubAllGlobals();
    expect(mobileQrScannerAvailable('Mozilla/5.0 (Linux; Android 15)')).toBe(false);
  });

  it('requests camera access and scans only QR codes', async () => {
    scanner.checkPermissions.mockResolvedValue('prompt');
    scanner.requestPermissions.mockResolvedValue('granted');
    scanner.scan.mockResolvedValue({
      content: '  bitsov://pair/ticket  ',
      format: 'QR_CODE',
      bounds: null,
    });

    await expect(scanPairingLink()).resolves.toBe('bitsov://pair/ticket');
    expect(scanner.requestPermissions).toHaveBeenCalledTimes(1);
    expect(scanner.scan).toHaveBeenCalledWith({
      cameraDirection: 'back',
      windowed: false,
      formats: ['QR_CODE'],
    });
  });

  it('fails closed when camera access is denied', async () => {
    scanner.checkPermissions.mockResolvedValue('denied');
    scanner.requestPermissions.mockResolvedValue('denied');

    await expect(scanPairingLink()).rejects.toThrow('Camera access is required');
    expect(scanner.scan).not.toHaveBeenCalled();
  });
});
it('marks camera denial for Settings recovery and rejects non-pairing QR content', async () => {
  scanner.checkPermissions.mockResolvedValue('denied');
  scanner.requestPermissions.mockResolvedValue('denied');
  await expect(scanPairingLink()).rejects.toMatchObject({ kind: 'camera' });
  scanner.checkPermissions.mockResolvedValue('granted');
  scanner.scan.mockResolvedValue({ content: 'unrelated QR' });
  await expect(scanPairingLink()).rejects.toThrow();
});
