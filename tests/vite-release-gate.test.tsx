import { describe, expect, it } from 'vitest';
import { assistantIncluded } from '../vite.config';

// Tauri CLI 2.x hooks (beforeBuildCommand / beforeDevCommand) always set
// TAURI_ENV_PLATFORM and set TAURI_ENV_DEBUG="true" only for debug builds.
// A release `tauri build` leaves TAURI_ENV_DEBUG unset; it is never "false".
describe('vite assistant release gate', () => {
  it('omits the assistant page from a release tauri build', () => {
    expect(assistantIncluded({ TAURI_ENV_PLATFORM: 'darwin' })).toBe(false);
  });

  it('omits it when TAURI_ENV_DEBUG is anything but "true" under Tauri', () => {
    expect(assistantIncluded({ TAURI_ENV_PLATFORM: 'darwin', TAURI_ENV_DEBUG: 'false' })).toBe(false);
    expect(assistantIncluded({ TAURI_ENV_PLATFORM: 'darwin', TAURI_ENV_DEBUG: '' })).toBe(false);
  });

  it('includes it for a debug tauri build or tauri dev', () => {
    expect(assistantIncluded({ TAURI_ENV_PLATFORM: 'darwin', TAURI_ENV_DEBUG: 'true' })).toBe(true);
  });

  it('includes it for a plain npm run build (CI compile gate)', () => {
    expect(assistantIncluded({})).toBe(true);
  });
});
