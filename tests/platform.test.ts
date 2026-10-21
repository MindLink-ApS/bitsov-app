import { describe, expect, it } from 'vitest';
import { appPlatform, deviceWords, isMobilePlatform } from '../src/platform';
import { refusalText } from '../src/control/ownerApproval';
import { androidQrScannerAvailable } from '../src/pairingScanner';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

describe('platform-aware device words', () => {
  it('a Mac keeps Touch ID and "this Mac"; an iPhone says biometrics; Android says "this phone"', () => {
    expect(deviceWords('desktop')).toMatchObject({ device: 'Mac', biometric: 'Touch ID', unlockButton: 'Unlock with Touch ID' });
    expect(deviceWords('ios')).toMatchObject({ device: 'iPhone', biometric: 'biometrics', unlockButton: 'Unlock with biometrics' });
    expect(deviceWords('android')).toMatchObject({ device: 'phone', biometric: 'biometrics', unlockButton: 'Unlock with biometrics' });
  });

  it('a cancelled approval names the platform\'s biometric', () => {
    expect(refusalText('device_cancelled', {}, 'desktop')).toBe('Touch ID was cancelled. Nothing was approved.');
    expect(refusalText('device_cancelled', {}, 'ios')).toBe('The biometric check was cancelled. Nothing was approved.');
    expect(refusalText('device_cancelled', {}, 'android')).toBe('The biometric check was cancelled. Nothing was approved.');
    // Outside the app runtime (tests, browser preview) the default stays the Mac wording.
    expect(refusalText('device_cancelled')).toBe('Touch ID was cancelled. Nothing was approved.');
  });
});

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
