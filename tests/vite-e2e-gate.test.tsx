import { describe, expect, it } from 'vitest';
import { uiE2eEnabled } from '../vite.config';

// The UI-E2E driver (tests/e2e/driver.js) is injected only by the dev server,
// and only when the runner asks for it (scripts/ui-e2e-two-node.sh).
describe('vite UI-E2E driver gate', () => {
  it('is on only for `vite serve` with BITSOV_UI_E2E=1', () => {
    expect(uiE2eEnabled('serve', { BITSOV_UI_E2E: '1' })).toBe(true);
  });

  it('is off for a normal dev server', () => {
    expect(uiE2eEnabled('serve', {})).toBe(false);
    expect(uiE2eEnabled('serve', { BITSOV_UI_E2E: 'true' })).toBe(false);
  });

  it('is never in a build, even with the variable set', () => {
    expect(uiE2eEnabled('build', { BITSOV_UI_E2E: '1' })).toBe(false);
    expect(uiE2eEnabled('build', { BITSOV_UI_E2E: '1', TAURI_ENV_PLATFORM: 'darwin' })).toBe(false);
  });
});
