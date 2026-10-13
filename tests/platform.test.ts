import { describe, expect, it } from 'vitest';
import { appPlatform, isMobilePlatform } from '../src/platform';
import { androidQrScannerAvailable } from '../src/pairingScanner';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

describe('the app platform, from its own Tauri runtime', () => {
  it('names Android, iOS (iPhone, and iPadOS that reports Macintosh with touch) and desktop', () => {
    expect(appPlatform(ANDROID, 5, true)).toBe('android');
    expect(appPlatform(IPHONE, 5, true)).toBe('ios');
    expect(appPlatform(IPAD_DESKTOP, 5, true)).toBe('ios');
    expect(appPlatform(MAC, 0, true)).toBe('desktop');
  });

  it('outside the Tauri runtime it is never a phone (a browser preview is not the app)', () => {
    expect(appPlatform(IPHONE, 5, false)).toBe('desktop');
    expect(appPlatform(ANDROID, 5, false)).toBe('desktop');
  });

  it('a phone is Android or iOS; the Android scanner stays Android only', () => {
    expect(isMobilePlatform('android')).toBe(true);
    expect(isMobilePlatform('ios')).toBe(true);
    expect(isMobilePlatform('desktop')).toBe(false);
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      expect(androidQrScannerAvailable(ANDROID)).toBe(true);
      expect(androidQrScannerAvailable(IPHONE)).toBe(false);
    } finally { delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__; }
  });
});
