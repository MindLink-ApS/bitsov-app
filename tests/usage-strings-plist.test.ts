import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The mic, camera and local network prompts are written twice: Info.plist (macOS) and
// Info.ios.plist (iOS). Keep them word-for-word identical so the two
// platforms never ask for the same permission in different words.

const plist = (f: string) => readFileSync(join(__dirname, '../src-tauri', f), 'utf8');

function usage(src: string, key: string): string | undefined {
  const m = src.match(new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`));
  return m?.[1];
}

describe('permission usage strings', () => {
  const mac = plist('Info.plist');
  const ios = plist('Info.ios.plist');
  for (const key of ['NSMicrophoneUsageDescription', 'NSCameraUsageDescription', 'NSLocalNetworkUsageDescription']) {
    it(`${key} matches between macOS and iOS`, () => {
      const m = usage(mac, key);
      expect(m, `${key} missing in Info.plist`).toBeTruthy();
      expect(usage(ios, key)).toBe(m);
    });
  }
});
