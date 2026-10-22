import { normalizePairingLink } from './onboarding/pairing';
import { appPlatform } from './platform';
import {
  cancel,
  checkPermissions,
  Format,
  requestPermissions,
  scan,
} from '@tauri-apps/plugin-barcode-scanner';

/** Native barcode scanner is registered on both mobile targets. */
export function mobileQrScannerAvailable(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints ?? 0,
): boolean {
  return ['android', 'ios'].includes(appPlatform(userAgent, maxTouchPoints));
}

export async function scanPairingLink(): Promise<string> {
  let permission = await checkPermissions();
  if (permission !== 'granted') permission = await requestPermissions();
  if (permission !== 'granted') {
    throw Object.assign(new Error('Camera access is required to scan a pairing QR code.'), { kind: 'camera' });
  }
  const result = await scan({
    cameraDirection: 'back',
    windowed: false,
    formats: [Format.QRCode],
  });
  const link = result.content.trim();
  if (!link) throw new Error('The scanned QR code was empty.');
  return normalizePairingLink(link);
}

export const cancelPairingScan = () => cancel();
