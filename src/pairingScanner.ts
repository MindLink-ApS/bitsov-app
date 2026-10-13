import { appPlatform } from './platform';
import {
  checkPermissions,
  Format,
  requestPermissions,
  scan,
} from '@tauri-apps/plugin-barcode-scanner';

/** The Android barcode-scanner plugin: Android only (iOS has no scanner wired here). */
export function androidQrScannerAvailable(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  return appPlatform(userAgent, 0) === 'android';
}

export async function scanPairingLink(): Promise<string> {
  let permission = await checkPermissions();
  if (permission !== 'granted') permission = await requestPermissions();
  if (permission !== 'granted') {
    throw new Error('Camera access is required to scan a pairing QR code.');
  }
  const result = await scan({
    cameraDirection: 'back',
    formats: [Format.QRCode],
  });
  const link = result.content.trim();
  if (!link) throw new Error('The scanned QR code was empty.');
  return link;
}
