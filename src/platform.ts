/**
 * Which platform this app runs on, from the app's own runtime: a Tauri
 * webview (`__TAURI_INTERNALS__`) plus the platform the webview reports. No
 * width or layout guess. iPadOS reports itself as "Macintosh"; touch points
 * tell it apart from a Mac. (A Tauri OS plugin would be the stronger signal;
 * it is not part of this app.)
 */
export type AppPlatform = 'android' | 'ios' | 'desktop';

export function appPlatform(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints ?? 0,
  tauri = '__TAURI_INTERNALS__' in globalThis,
): AppPlatform {
  if (!tauri) return 'desktop';
  if (/\bAndroid\b/i.test(userAgent)) return 'android';
  if (/\biPhone\b|\biPad\b|\biPod\b/i.test(userAgent)) return 'ios';
  if (/\bMacintosh\b/i.test(userAgent) && maxTouchPoints > 1) return 'ios';
  return 'desktop';
}

/**
 * "computer" on a desktop, "phone" on a phone or tablet: the word for the
 * device this app runs on, for copy like "Nothing leaves this computer".
 */
export const deviceWord = (platform: AppPlatform = appPlatform()) => (platform === 'desktop' ? 'computer' : 'phone');

/** A phone or tablet build (Android or iOS): there is no "This Mac" to run a node on. */
export const isMobilePlatform = (platform: AppPlatform = appPlatform()) => platform !== 'desktop';
